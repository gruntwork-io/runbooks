# CIS Compliance

## Achieving Compliance

Achieving CIS `v1.5.0` compliance is a multi-faceted process that is initiated via usage of [account baselines](/_envcommon/landingzone/account-baseline-app-cis-base.hcl) applied to all accounts and the [baselines applied to this `security` account](/security/_global/account-baseline/terragrunt.hcl).

These Terragrunt configurations ensure application of the baselines required for compliance with the CIS `v1.5.0` benchmark, however it is important to note that compliance is not a one-time event. It is an ongoing process that requires continuous monitoring and maintenance.

Security best practices have to be continuously enforced, and all accounts have to be continuously monitored for compliance.

## Verifying Compliance

[CIS `v1.5.0`](https://www.cisecurity.org/cis-benchmarks) compliance is validated via the use of a tool named [powerpipe](https://github.com/turbot/powerpipe). This tool analyzes the state of AWS accounts across multiple regions and can report on the compliance of those accounts to the CIS benchmark via the [steampipe-mod-aws-compliance powerpipe mod](https://hub.powerpipe.io/mods/turbot/aws_compliance/controls/benchmark.cis_v150).

### Getting Started

1. Install [powerpipe](https://github.com/turbot/powerpipe?tab=readme-ov-file#install-powerpipe)
2. Install the [steampipe-mod-aws-compliance powerpipe mod](https://hub.powerpipe.io/mods/turbot/aws_compliance/controls/benchmark.cis_v150#usage).
3. Configure your `~/.steampipe/config/aws.spc` to have configurations for all accounts and regions ([see Configuring the `aws.spc`](#configuring-the-awsspc)).
4. Start up the `steampipe` service ([see Starting up the `steampipe` service](#starting-up-the-steampipe-service)).
5. Start up the `powerpipe server` ([see Starting up the `powerpipe` server](#starting-up-the-powerpipe-server)).
6. Run the powerpipe benchmark checks ([see Running the `powerpipe` benchmark checks](#running-the-powerpipe-benchmark-checks)).

### Configuring the `aws.spc`

The [`aws.spc` file is a configuration file](https://hub.steampipe.io/plugins/turbot/aws) that is used by `powerpipe` to connect to AWS accounts and regions. It has many configurations available, but the following should be sufficient to get started (the profiles and accounts listed might need adjusting).

Note that the top level `aws` connection is an aggregator of all other connections that start with `aws_`. This is a convenience to allow for running queries across all accounts and relevant regions.

```text
connection "aws" {
  type        = "aggregator"
  plugin      = "aws"
  connections = ["aws_*"]

  regions = ["us-east-1", "us-west-1"]
}

connection "aws_security" {
  plugin = "aws"

  regions = ["us-east-1", "us-west-1"]

  profile = "security"
}

# ...

```

Setting up all the connections to different accounts after the initial `aws` connection that aggregates them all can be a bit painful if done by hand, however, utilizing a script that looks something like the following might be preferable way to speed this up:

```bash
for account in $(yq '. | keys | .[]' account.yml); do
    if [[ $account != "management" ]]; then
        cat <<EOF >> ~/.steampipe/config/aws.spc
connection "aws_${account}" {
    plugin = "aws"

    regions = ["us-east-1", "us-west-1"]

    profile = "${account}"
}
EOF

    fi
done

```

Note that the exact `profile`s used might differ if your local profiles don't align with the name of the AWS accounts, and the regions might need adjusting to match the regions that the accounts are operating in.

### Starting up the `steampipe` service

This is the service that runs locally to handle storing and querying the results of the powerpipe queries in a local postgres database.

### Starting up the `powerpipe` server

This is the server that will run locally that handles the queries for inspecting AWS accounts and returning responses for queries.

> [!TIP]
> The session that runs the `powerpipe` server is the session that actually sends API calls to AWS. This means that it should be run in a session that has the necessary permissions to inspect the accounts, and remain running for the duration of the time that the `powerpipe` benchmark checks are being run.

### Running the `powerpipe` benchmark checks

The `powerpipe` benchmark checks are run via the `powerpipe` command line tool **in a separate terminal**. The following command will run the checks for the CIS `v1.5.0` benchmark against the running `powerpipe` server:

```bash
powerpipe benchmark run aws_compliance.benchmark.cis_v150 --output html > results/all-accounts-cis-150.html
```

> [!TIP]
> Note that the `--output` is set to `html` in the above command. This is to make it easier to share the results with others. More information on the `powerpipe` CLI can be found [here](https://powerpipe.io/docs/run).

## Common Findings

Even a perfectly compliant account can have findings that turn up in the `powerpipe` scan as something other than `ok`. This is because some aspects of CIS compliance have to be verified manually, and some aspects of compliant configurations will show up as `warning` or `error` in the scan (for example, some rules require that all regions are enabled and used, which is not desireable or more secure for most organizations).

When assessing the results of your `powerpipe` scan, it is important to understand the context of the findings and to verify that the findings are actually issues that need to be addressed. Before digging into them too deeply, run a search on this page for the title of the finding to see if it is a common issue that is known to be a false positive or easily addressed.

To help with this, some frequently found issues are listed below:

### Credential Report Not Generated

These findings will appear if you have not generated a recent IAM Credentials Report. Make sure that you do before running your scan. If you have, and you still see this finding, see the details of the finding for more information.

- 1.7 Eliminate use of the 'root' user for administrative and daily tasks
- 1.10 Ensure multi-factor authentication (MFA) is enabled for all IAM users that have a console password
- 1.11 Do not setup access keys during initial user setup for all IAM users that have a console password
- 1.12 Ensure credentials unused for 45 days or greater are disabled

### Unused Regions

These findings will appear if you have regions enabled that are not in use. This includes the regions that are commented out in the [multi_region_common](../../multi_region_common.hcl) file. If you have regions that are not in use showing up here, you can safely ignore the finding.

- 1.20 Ensure that IAM Access analyzer is enabled for all regions
- 3.1 Ensure CloudTrail is enabled in all regions
- 3.5 Ensure AWS Config is enabled in all regions
- 4.16 Ensure AWS Security Hub is enabled

### CloudTrail Logs

These findings can appear in accounts other than the central `logs` account, because they don't have CloudWatch Logs integrated with CloudTrail trails there. The architecture of DevOps Foundations is designed to have all CloudTrail logs sent to the central `logs` account, and integration of CloudWatch Logs and associated filters and alarms are handled there. If you see this finding in an account other than the `logs` account, you can safely ignore it.

- 3.4 Ensure CloudTrail trails are integrated with CloudWatch Logs
- 4.1 Ensure a log metric filter and alarm exist for unauthorized API calls
- 4.2 Ensure a log metric filter and alarm exist for Management Console sign-in without MFA
- 4.3 Ensure a log metric filter and alarm exist for usage of 'root' account
- 4.4 Ensure a log metric filter and alarm exist for IAM policy changes
- 4.5 Ensure a log metric filter and alarm exist for CloudTrail configuration changes
- 4.6 Ensure a log metric filter and alarm exist for AWS Management Console authentication failures
- 4.7 Ensure a log metric filter and alarm exist for disabling or scheduled deletion of customer created CMKs
- 4.8 Ensure a log metric filter and alarm exist for S3 bucket policy changes
- 4.9 Ensure a log metric filter and alarm exist for AWS Config configuration changes
- 4.10 Ensure a log metric filter and alarm exist for security group changes
- 4.11 Ensure a log metric filter and alarm exist for changes to Network Access Control Lists (NACL)
- 4.12 Ensure a log metric filter and alarm exist for changes to network gateways
- 4.13 Ensure a log metric filter and alarm exist for route table changes
- 4.14 Ensure a log metric filter and alarm exist for VPC changes
- 4.15 Ensure a log metric filter and alarm exists for AWS Organizations changes

### IAM User Permissions Through Groups

If you have manually provisioned IAM users, you may get findings that indicate that you have users with permissions that are not granted through groups. This is a best practice for users, but a sustainable way to address this finding is to avoid using IAM users where possible. Consider using [IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html) users.

- 1.15 Ensure IAM Users Receive Permissions Only Through Groups

### MFA Delete

These findings will appear if you have S3 buckets that do not have MFA Delete enabled. This is recommended as part of the CIS benchmark, but it is not required to have a strong security posture. It is operationally expensive to have MFA Delete enabled on all S3 buckets, and it is not recommended to do so unless you have a specific use case that requires it.

More on this can be found [here](https://github.com/gruntwork-io/terraform-aws-security/blob/9fa9b88094b3784ee166b03a9b3e55dbecc04161/modules/private-s3-bucket/README.md?plain=1#L17).

Our recommendation is to only enable this for very sensitive buckets with valuable data that cannot be easily recovered, or replicated for redundancy.

- 2.1.3 Ensure MFA Delete is enabled on S3 buckets

### Enable Macie on All Buckets

The `macie_buckets_to_analyze` input in the `terragrunt.hcl` file in the `account-baseline` folder for the `logs` account is what controls which buckets are automatically inspected for Personally Identifiable Information (PII) by Macie. Note that this service can be *very* expensive, and it is highly unlikely that you have any PII in your state buckets, which is likely to pop up on these scans. You can choose to add those buckets to this field to avoid having them show up in results.

- 2.1.4 Ensure all data in Amazon S3 has been discovered, classified and secured when required

### Ensure CMK Rotation is Enabled

These findings will appear if you have customer managed keys that are not set to rotate.

If you have provisioned keys manually that are not rotating automatically, consider leveraging the [kms-master-key](https://github.com/gruntwork-io/terraform-aws-security/blob/main/modules/kms-master-key/variables.tf#L50) module to provision keys that rotate automatically.

- 3.8 Ensure rotation for customer created symmetric CMKs is enabled

### Non-compliant VPC Resources

The VPCs that are provisioned using [terraform-aws-cis-service-catalog](https://github.com/gruntwork-io/terraform-aws-cis-service-catalog/blob/master/modules/networking/vpc) have sensible defaults designed to keep you CIS compliant. If you have VPCs that where provisioned manually, or are the default VPCs for a provisioned account, you may see findings related to related resources that are not compliant.

If you would like to avoid having these default VPCs created by default going forward, consider disabling them following the instructions [here](https://docs.gruntwork.io/foundations/landing-zone/enable-control-tower/#initial-configuration).

- 3.9 Ensure VPC flow logging is enabled in all VPCs
- 5.1 Ensure no Network ACLs allow ingress from 0.0.0.0/0 to remote server administration ports
- 5.4 Ensure the default security group of every VPC restricts all traffic

### Control Tower Managed CloudTrail Trails

The default CloudTrail Trail created by Control Tower is not configured to log all events for S3 buckets. You should definitely evaluate whether you want to enable this feature for particular buckets, but you likely do not want this enabled for all S3 buckets, due to the associated costs with ingesting all of that data.

Consider enabling this if you have sensitive data in a bucket that you want to monitor for access or changes. Without this enabled, you will have a harder time auditing who is accessing or changing data in your S3 buckets.

- 3.10 Ensure that Object-level logging for write events is enabled for S3 bucket
- 3.11 Ensure that Object-level logging for read events is enabled for S3 bucket

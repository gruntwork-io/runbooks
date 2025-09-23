# Launch a new DataBricks cluster

This repo contains modules for deploying and managing relational databases such as MySQL, PostgreSQL, Oracle, and
Aurora on AWS using Amazon's [Relational Database Service (RDS)](https://aws.amazon.com/rds/). It also contains a module
for creating network-attached filesystems on AWS using Amazon's [Elastic File System (EFS)](https://aws.amazon.com/efs/), and modules for
configuring [AWS Backup](https://aws.amazon.com/backup/).

![RDS architecture](_docs/rds-architecture.png)

WEBFORM

## Table of Contents

- [Features](#features)
- [Learn](#learn)
  - [Core concepts](#core-concepts)
  - [Repo organization](#repo-organization)
- [Deploy](#deploy)
  - [Non-production deployment (quick start for learning)](#non-production-deployment-quick-start-for-learning)
  - [Production deployment](#production-deployment)
- [Manage](#manage)
  - [Day-to-day operations](#day-to-day-operations)
  - [Major changes](#major-changes)
- [Support](#support)
- [Contributions](#contributions)
- [License](#license)

## Features

* Deploy a fully-managed relational database
* Supports MySQL, PostgreSQL, MariaDB, Oracle, SQL Server, Aurora, and Aurora Serverless
* Automatic failover to a standby in another availability zone
* Read replicas
* Automatic nightly snapshots
* Automatic copying of snapshots to other AWS accounts and regions for disaster recovery
* Scale to zero with Aurora Serverless
* Create a managed NFSv4-compliant file system
* Create an configure Backup vaults, plans and selections for central, automated and customizable
management of recovery points

## Learn

> **Note:** This repo is a part of [the Gruntwork Infrastructure as Code Library](https://gruntwork.io/infrastructure-as-code-library/), a collection of reusable, battle-tested, production ready infrastructure code. If you've never used the Infrastructure as Code Library before, make sure to read [How to use the Gruntwork Infrastructure as Code Library](https://docs.gruntwork.io/library/overview/)!

### Core concepts

* [What is Amazon RDS?](/modules/rds/core-concepts.md#what-is-amazon-rds)
* [Common gotchas with RDS](/modules/rds/core-concepts.md#common-gotchas)
* [RDS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html): Amazon's docs for RDS that
  cover core concepts such as the types of databases supported, security, backup & restore, and monitoring.
* [_Designing Data Intensive Applications_](https://dataintensive.net): the best book we've found for understanding data
  systems, including relational databases, NoSQL, replication, sharding, consistency, and so on.
* [What is AWS Backup?](/modules/backup-vault/core-concepts.md/#what-is-aws-backup)

### Repo organization

* [modules](/modules): the main implementation code for this repo, broken down into multiple standalone, orthogonal submodules.
  * [modules/aurora](/modules/aurora): use this module to deploy all Amazon's Aurora and Aurora Serverless databases.
  * [modules/efs](/modules/efs): use this module to deploy Amazon Elastic File System (EFS), a file system that
provides NFSv4-compatible storage that can be used with other AWS services, such as EC2 instances.
  * [modules/backup-vault](/modules/backup-vault): use this module to create and configure AWS Backup vaults, notifications, locks.
  * [modules/backup-plan](/modules/backup-plan): use this module to create and configure AWS Backup plans, schedules and resource selections.
  * [modules/lambda-create-snapshot](/modules/lambda-create-snapshot): use this module and the other
`lambda-xxx-snapshot` modules to create custom snapshots of your databases and copy those snapshots to other AWS accounts.
  * [modules/rds](/modules/rds): use this module to deploy all non-Amazon databases, including MySQL, PostgreSQL,
   MariaDB, Oracle, and SQL Server.
  * [modules/redshift](/modules/redshift): use this module to deploy Amazon Redshift cluster that you can use as a data warehouse.
* [examples](/examples): This folder contains working examples of how to use the submodules.
* [test](/test): Automated tests for the modules and examples.

## Deploy

### Non-production deployment (quick start for learning)

If you just want to try this repo out for experimenting and learning, check out the following resources:

* [examples folder](/examples): The `examples` folder contains sample code optimized for learning, experimenting,
  and testing (but not production usage).

### Production deployment

If you want to deploy this repo in production, check out the following resources:

* [rds module in the Service Catalog for-production examples](https://github.com/gruntwork-io/terraform-aws-service-catalog/blob/main/examples/for-production/infrastructure-live/dev/us-west-2/dev/data-stores/rds/terragrunt.hcl): Production-ready sample code from the Service Catalog examples.

## Manage

### Day-to-day operations

* [How to connect to an RDS instance](/modules/rds/core-concepts.md#how-do-you-connect-to-the-database)
* [How to authenticate to RDS with IAM](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAM.html)
* [How to connect to an Aurora instance](/modules/aurora/core-concepts.md#how-do-you-connect-to-the-database)
* [How to scale RDS](/modules/rds/core-concepts.md#how-do-you-scale-this-database)
* [How to scale Aurora](/modules/aurora/core-concepts.md#how-do-you-scale-this-database)
* [How to backup RDS snapshots to a separate AWS account](/modules/lambda-create-snapshot#how-do-you-backup-your-rds-snapshots-to-a-separate-aws-account)

### Major changes

* [Upgrading a DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.Upgrading.html)
* [Restoring from a DB snapshot](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html)

## Support

If you need help with this repo or anything else related to infrastructure or DevOps, Gruntwork offers [Commercial Support](https://gruntwork.io/support/) via Slack, email, and phone/video. If you're already a Gruntwork customer, hop on Slack and ask away! If not, [subscribe now](https://www.gruntwork.io/pricing/). If you're not sure, feel free to email us at [support@gruntwork.io](mailto:support@gruntwork.io).

## Contributions

Contributions to this repo are very welcome and appreciated! If you find a bug or want to add a new feature or even contribute an entirely new module, we are very happy to accept pull requests, provide feedback, and run your changes through our automated test suite.

Please see [Contributing to the Gruntwork Infrastructure as Code Library](https://docs.gruntwork.io/library/overview/#contributing-to-the-gruntwork-infrastructure-as-code-library) for instructions.

## License

Please see [LICENSE.txt](LICENSE.txt) for details on how the code in this repo is licensed.
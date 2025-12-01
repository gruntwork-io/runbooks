# See https://github.com/gruntwork-io/terraform-aws-ci/blob/main/modules/sign-binary-helpers/
# for further instructions on how to sign the binary + submitting for notarization.

source = ["./bin/runbooks_darwin_amd64"]

bundle_id = "io.gruntwork.app.runbooks"

apple_id {
  username = "@env:AC_USERNAME"
}

sign {
  application_identity = "Developer ID Application: Gruntwork, Inc."
}

zip {
  output_path = "runbooks_darwin_amd64.zip"
}


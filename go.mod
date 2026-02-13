module runbooks

go 1.26.0

require (
	github.com/aws/aws-sdk-go-v2 v1.41.1
	github.com/aws/aws-sdk-go-v2/config v1.32.7
	github.com/aws/aws-sdk-go-v2/credentials v1.19.7
	github.com/aws/aws-sdk-go-v2/service/account v1.30.1
	github.com/aws/aws-sdk-go-v2/service/iam v1.53.2
	github.com/aws/aws-sdk-go-v2/service/sso v1.30.9
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.35.13
	github.com/aws/aws-sdk-go-v2/service/sts v1.41.6
	github.com/creack/pty v1.1.24
	github.com/fsnotify/fsnotify v1.9.0
	github.com/gin-contrib/cors v1.7.6
	github.com/gin-gonic/gin v1.10.1
	github.com/gruntwork-io/boilerplate v0.11.2-0.20260212221136-406853de7dfc
	github.com/hashicorp/hcl/v2 v2.24.0
	github.com/mixpanel/mixpanel-go v1.2.1
	github.com/spf13/cobra v1.10.1
	github.com/stretchr/testify v1.11.1
	github.com/zclconf/go-cty v1.17.0
	gopkg.in/ini.v1 v1.67.0
)

require (
	github.com/agext/levenshtein v1.2.3 // indirect
	github.com/apparentlymart/go-textseg/v15 v15.0.0 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.4 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/ini v1.8.4 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.4.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.9.8 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.19.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.95.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.0.5 // indirect
	github.com/aws/smithy-go v1.24.0 // indirect
	github.com/clipperhouse/stringish v0.1.1 // indirect
	github.com/clipperhouse/uax29/v2 v2.3.1 // indirect
	github.com/envoyproxy/go-control-plane/envoy v1.36.0 // indirect
	github.com/go-jose/go-jose/v4 v4.1.3 // indirect
	github.com/hashicorp/aws-sdk-go-base/v2 v2.0.0-beta.70 // indirect
	github.com/mattn/go-zglob v0.0.6 // indirect
	github.com/mitchellh/go-wordwrap v1.0.1 // indirect
	github.com/spiffe/go-spiffe/v2 v2.6.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.yaml.in/yaml/v2 v2.4.3 // indirect
	golang.org/x/exp v0.0.0-20260112195511-716be5621a96 // indirect
	golang.org/x/mod v0.32.0 // indirect
	golang.org/x/tools v0.41.0 // indirect
)

// Note that importing github.com/gruntwork-io/boilerplate v0.10.0 brings in 100+ indirect dependencies!
// Used an LLM to identify the indirect dependencies from Boilerplate.
// TODO: Update Boilerplate to fix this.
require (
	atomicgo.dev/cursor v0.2.0 // indirect; indirect from boilerplate
	atomicgo.dev/keyboard v0.2.9 // indirect; indirect from boilerplate
	atomicgo.dev/schedule v0.1.0 // indirect; indirect from boilerplate
	cel.dev/expr v0.25.1 // indirect; indirect from boilerplate
	cloud.google.com/go v0.123.0 // indirect; indirect from boilerplate
	cloud.google.com/go/auth v0.18.1 // indirect; indirect from boilerplate
	cloud.google.com/go/auth/oauth2adapt v0.2.8 // indirect; indirect from boilerplate
	cloud.google.com/go/compute/metadata v0.9.0 // indirect; indirect from boilerplate
	cloud.google.com/go/iam v1.5.3 // indirect; indirect from boilerplate
	cloud.google.com/go/monitoring v1.24.3 // indirect; indirect from boilerplate
	cloud.google.com/go/storage v1.59.1 // indirect; indirect from boilerplate
	dario.cat/mergo v1.0.2 // indirect; indirect from boilerplate
	github.com/AlecAivazis/survey/v2 v2.3.7 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/detectors/gcp v1.31.0 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/metric v0.55.0 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/internal/resourcemapping v0.55.0 // indirect; indirect from boilerplate
	github.com/Masterminds/goutils v1.1.1 // indirect; indirect from boilerplate
	github.com/Masterminds/semver/v3 v3.4.0 // indirect; indirect from boilerplate
	github.com/Masterminds/sprig/v3 v3.3.0 // indirect; indirect from boilerplate
	github.com/asaskevich/govalidator v0.0.0-20230301143203-a9d515a09cc2 // indirect; indirect from boilerplate
	github.com/bgentry/go-netrc v0.0.0-20140422174119-9fd32a8b3d3d // indirect; indirect from boilerplate
	github.com/bytedance/gopkg v0.1.3 // indirect
	github.com/bytedance/sonic v1.14.1 // indirect
	github.com/bytedance/sonic/loader v0.3.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect; indirect from boilerplate
	github.com/cloudwego/base64x v0.1.6 // indirect
	github.com/cncf/xds/go v0.0.0-20260121142036-a486691bba94 // indirect; indirect from boilerplate
	github.com/containerd/console v1.0.5 // indirect; indirect from boilerplate
	github.com/cpuguy83/go-md2man/v2 v2.0.7 // indirect; indirect from boilerplate
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect; indirect from boilerplate
	github.com/envoyproxy/protoc-gen-validate v1.3.0 // indirect; indirect from boilerplate
	github.com/fatih/color v1.18.0 // indirect; indirect from boilerplate
	github.com/felixge/httpsnoop v1.0.4 // indirect; indirect from boilerplate
	github.com/gabriel-vasile/mimetype v1.4.12 // indirect; indirect from boilerplate
	github.com/gin-contrib/sse v1.1.0 // indirect
	github.com/go-errors/errors v1.5.1 // indirect; indirect from boilerplate
	github.com/go-logr/logr v1.4.3 // indirect; indirect from boilerplate
	github.com/go-logr/stdr v1.2.2 // indirect; indirect from boilerplate
	github.com/go-ozzo/ozzo-validation v3.6.0+incompatible // indirect; indirect from boilerplate
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-playground/validator/v10 v10.27.0 // indirect
	github.com/goccy/go-json v0.10.5 // indirect
	github.com/google/go-jsonnet v0.21.0 // indirect; indirect from boilerplate
	github.com/google/s2a-go v0.1.9 // indirect; indirect from boilerplate
	github.com/google/uuid v1.6.0 // indirect; indirect from boilerplate
	github.com/googleapis/enterprise-certificate-proxy v0.3.11 // indirect; indirect from boilerplate
	github.com/googleapis/gax-go/v2 v2.16.0 // indirect; indirect from boilerplate
	github.com/gookit/color v1.6.0 // indirect; indirect from boilerplate
	github.com/gruntwork-io/go-commons v0.17.2 // indirect; indirect from boilerplate
	github.com/hashicorp/errwrap v1.1.0 // indirect; indirect from boilerplate
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect; indirect from boilerplate
	github.com/hashicorp/go-getter v1.8.4 // indirect; indirect from boilerplate
	github.com/hashicorp/go-multierror v1.1.1 // indirect; indirect from boilerplate
	github.com/hashicorp/go-version v1.8.0 // indirect; indirect from boilerplate
	github.com/huandu/xstrings v1.5.0 // indirect; indirect from boilerplate
	github.com/inancgumus/screen v0.0.0-20190314163918-06e984b86ed3 // indirect; indirect from boilerplate
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/kballard/go-shellquote v0.0.0-20180428030007-95032a82bc51 // indirect; indirect from boilerplate
	github.com/klauspost/compress v1.18.3 // indirect; indirect from boilerplate
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/lithammer/fuzzysearch v1.1.8 // indirect; indirect from boilerplate
	github.com/mattn/go-colorable v0.1.14 // indirect; indirect from boilerplate
	github.com/mattn/go-isatty v0.0.20 // indirect; indirect from boilerplate
	github.com/mattn/go-runewidth v0.0.19 // indirect; indirect from boilerplate
	github.com/mgutz/ansi v0.0.0-20200706080929-d51e80ef957d // indirect; indirect from boilerplate
	github.com/mitchellh/copystructure v1.2.0 // indirect; indirect from boilerplate
	github.com/mitchellh/go-homedir v1.1.0 // indirect; indirect from boilerplate
	github.com/mitchellh/reflectwalk v1.0.2 // indirect; indirect from boilerplate
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/pelletier/go-toml/v2 v2.2.4 // indirect
	github.com/planetscale/vtprotobuf v0.6.1-0.20240319094008-0393e58bdf10 // indirect; indirect from boilerplate
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect; indirect from boilerplate
	github.com/pterm/pterm v0.12.82 // indirect; indirect from boilerplate
	github.com/russross/blackfriday/v2 v2.1.0 // indirect; indirect from boilerplate
	github.com/shopspring/decimal v1.4.0 // indirect; indirect from boilerplate
	github.com/spf13/cast v1.10.0 // indirect; indirect from boilerplate
	github.com/spf13/pflag v1.0.10
	github.com/twitchyliquid64/golang-asm v0.15.1 // indirect
	github.com/ugorji/go/codec v1.3.0 // indirect
	github.com/ulikunitz/xz v0.5.15 // indirect; indirect from boilerplate
	github.com/urfave/cli/v2 v2.27.7 // indirect; indirect from boilerplate
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect; indirect from boilerplate
	github.com/xrash/smetrics v0.0.0-20250705151800-55b8f293f342 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/detectors/gcp v1.39.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.64.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.64.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel v1.39.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/metric v1.39.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/sdk v1.39.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/sdk/metric v1.39.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/trace v1.39.0 // indirect; indirect from boilerplate
	golang.org/x/arch v0.21.0 // indirect
	golang.org/x/crypto v0.47.0 // indirect; indirect from boilerplate
	golang.org/x/net v0.49.0 // indirect; indirect from boilerplate
	golang.org/x/oauth2 v0.34.0 // indirect; indirect from boilerplate
	golang.org/x/sync v0.19.0 // indirect; indirect from boilerplate
	golang.org/x/sys v0.40.0 // indirect; indirect from boilerplate
	golang.org/x/term v0.39.0 // indirect; indirect from boilerplate
	golang.org/x/text v0.33.0 // indirect; indirect from boilerplate
	golang.org/x/time v0.14.0 // indirect; indirect from boilerplate
	google.golang.org/api v0.262.0 // indirect; indirect from boilerplate
	google.golang.org/genproto v0.0.0-20260122232226-8e98ce8d340d // indirect; indirect from boilerplate
	google.golang.org/genproto/googleapis/api v0.0.0-20260122232226-8e98ce8d340d // indirect; indirect from boilerplate
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260122232226-8e98ce8d340d // indirect; indirect from boilerplate
	google.golang.org/grpc v1.79.1 // indirect; indirect from boilerplate
	google.golang.org/protobuf v1.36.11 // indirect; indirect from boilerplate
	gopkg.in/yaml.v2 v2.4.0 // indirect; indirect from boilerplate
	gopkg.in/yaml.v3 v3.0.1 // indirect from boilerplate
	sigs.k8s.io/yaml v1.6.0 // indirect; indirect from boilerplate
)

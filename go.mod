module runbooks

go 1.25.1

require (
	github.com/fsnotify/fsnotify v1.9.0
	github.com/gin-contrib/cors v1.7.6
	github.com/gin-gonic/gin v1.10.1
	github.com/gruntwork-io/boilerplate v0.10.0
	github.com/spf13/cobra v1.10.1
	github.com/stretchr/testify v1.11.1
)

require (
	github.com/mattn/go-zglob v0.0.6 // indirect
	golang.org/x/exp v0.0.0-20241009180824-f66d83c29e7c // indirect
)

// Note that importing github.com/gruntwork-io/boilerplate v0.10.0 brings in 100+ indirect dependencies!
// Used an LLM to identify the indirect dependencies from Boilerplate.
// TODO: Update Boilerplate to fix this.
require (
	atomicgo.dev/cursor v0.2.0 // indirect; indirect from boilerplate
	atomicgo.dev/keyboard v0.2.9 // indirect; indirect from boilerplate
	atomicgo.dev/schedule v0.1.0 // indirect; indirect from boilerplate
	cel.dev/expr v0.16.2 // indirect; indirect from boilerplate
	cloud.google.com/go v0.116.0 // indirect; indirect from boilerplate
	cloud.google.com/go/auth v0.9.8 // indirect; indirect from boilerplate
	cloud.google.com/go/auth/oauth2adapt v0.2.4 // indirect; indirect from boilerplate
	cloud.google.com/go/compute/metadata v0.5.2 // indirect; indirect from boilerplate
	cloud.google.com/go/iam v1.2.1 // indirect; indirect from boilerplate
	cloud.google.com/go/monitoring v1.21.1 // indirect; indirect from boilerplate
	cloud.google.com/go/storage v1.44.0 // indirect; indirect from boilerplate
	dario.cat/mergo v1.0.1 // indirect; indirect from boilerplate
	github.com/AlecAivazis/survey/v2 v2.3.7 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/detectors/gcp v1.24.2 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/metric v0.48.2 // indirect; indirect from boilerplate
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/internal/resourcemapping v0.48.2 // indirect; indirect from boilerplate
	github.com/Masterminds/goutils v1.1.1 // indirect; indirect from boilerplate
	github.com/Masterminds/semver/v3 v3.3.0 // indirect; indirect from boilerplate
	github.com/Masterminds/sprig/v3 v3.3.0 // indirect; indirect from boilerplate
	github.com/asaskevich/govalidator v0.0.0-20230301143203-a9d515a09cc2 // indirect; indirect from boilerplate
	github.com/aws/aws-sdk-go v1.55.5 // indirect; indirect from boilerplate
	github.com/bgentry/go-netrc v0.0.0-20140422174119-9fd32a8b3d3d // indirect; indirect from boilerplate
	github.com/bytedance/gopkg v0.1.3 // indirect
	github.com/bytedance/sonic v1.14.1 // indirect
	github.com/bytedance/sonic/loader v0.3.0 // indirect
	github.com/census-instrumentation/opencensus-proto v0.4.1 // indirect; indirect from boilerplate
	github.com/cespare/xxhash/v2 v2.3.0 // indirect; indirect from boilerplate
	github.com/cloudwego/base64x v0.1.6 // indirect
	github.com/cncf/xds/go v0.0.0-20240905190251-b4127c9b8d78 // indirect; indirect from boilerplate
	github.com/containerd/console v1.0.4 // indirect; indirect from boilerplate
	github.com/cpuguy83/go-md2man/v2 v2.0.6 // indirect; indirect from boilerplate
	github.com/davecgh/go-spew v1.1.1 // indirect; indirect from boilerplate
	github.com/envoyproxy/go-control-plane v0.13.0 // indirect; indirect from boilerplate
	github.com/envoyproxy/protoc-gen-validate v1.1.0 // indirect; indirect from boilerplate
	github.com/fatih/color v1.17.0 // indirect; indirect from boilerplate
	github.com/felixge/httpsnoop v1.0.4 // indirect; indirect from boilerplate
	github.com/gabriel-vasile/mimetype v1.4.10 // indirect; indirect from boilerplate
	github.com/gin-contrib/sse v1.1.0 // indirect
	github.com/go-errors/errors v1.5.1 // indirect; indirect from boilerplate
	github.com/go-logr/logr v1.4.2 // indirect; indirect from boilerplate
	github.com/go-logr/stdr v1.2.2 // indirect; indirect from boilerplate
	github.com/go-ozzo/ozzo-validation v3.6.0+incompatible // indirect; indirect from boilerplate
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-playground/validator/v10 v10.27.0 // indirect
	github.com/goccy/go-json v0.10.5 // indirect
	github.com/golang/groupcache v0.0.0-20210331224755-41bb18bfe9da // indirect; indirect from boilerplate
	github.com/google/go-jsonnet v0.20.0 // indirect; indirect from boilerplate
	github.com/google/s2a-go v0.1.8 // indirect; indirect from boilerplate
	github.com/google/uuid v1.6.0 // indirect; indirect from boilerplate
	github.com/googleapis/enterprise-certificate-proxy v0.3.4 // indirect; indirect from boilerplate
	github.com/googleapis/gax-go/v2 v2.13.0 // indirect; indirect from boilerplate
	github.com/gookit/color v1.5.4 // indirect; indirect from boilerplate
	github.com/gruntwork-io/go-commons v0.17.2 // indirect; indirect from boilerplate
	github.com/hashicorp/errwrap v1.1.0 // indirect; indirect from boilerplate
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect; indirect from boilerplate
	github.com/hashicorp/go-getter v1.7.9 // indirect; indirect from boilerplate
	github.com/hashicorp/go-multierror v1.1.1 // indirect; indirect from boilerplate
	github.com/hashicorp/go-safetemp v1.0.0 // indirect; indirect from boilerplate
	github.com/hashicorp/go-version v1.7.0 // indirect; indirect from boilerplate
	github.com/huandu/xstrings v1.5.0 // indirect; indirect from boilerplate
	github.com/inancgumus/screen v0.0.0-20190314163918-06e984b86ed3 // indirect; indirect from boilerplate
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/jmespath/go-jmespath v0.4.0 // indirect; indirect from boilerplate
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/kballard/go-shellquote v0.0.0-20180428030007-95032a82bc51 // indirect; indirect from boilerplate
	github.com/klauspost/compress v1.17.11 // indirect; indirect from boilerplate
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/lithammer/fuzzysearch v1.1.8 // indirect; indirect from boilerplate
	github.com/mattn/go-colorable v0.1.13 // indirect; indirect from boilerplate
	github.com/mattn/go-isatty v0.0.20 // indirect; indirect from boilerplate
	github.com/mattn/go-runewidth v0.0.16 // indirect; indirect from boilerplate
	github.com/mgutz/ansi v0.0.0-20200706080929-d51e80ef957d // indirect; indirect from boilerplate
	github.com/mitchellh/copystructure v1.2.0 // indirect; indirect from boilerplate
	github.com/mitchellh/go-homedir v1.1.0 // indirect; indirect from boilerplate
	github.com/mitchellh/reflectwalk v1.0.2 // indirect; indirect from boilerplate
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/pelletier/go-toml/v2 v2.2.4 // indirect
	github.com/planetscale/vtprotobuf v0.6.1-0.20240319094008-0393e58bdf10 // indirect; indirect from boilerplate
	github.com/pmezard/go-difflib v1.0.0 // indirect; indirect from boilerplate
	github.com/pterm/pterm v0.12.79 // indirect; indirect from boilerplate
	github.com/rivo/uniseg v0.4.7 // indirect; indirect from boilerplate
	github.com/russross/blackfriday/v2 v2.1.0 // indirect; indirect from boilerplate
	github.com/shopspring/decimal v1.4.0 // indirect; indirect from boilerplate
	github.com/spf13/cast v1.7.0 // indirect; indirect from boilerplate
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/twitchyliquid64/golang-asm v0.15.1 // indirect
	github.com/ugorji/go/codec v1.3.0 // indirect
	github.com/ulikunitz/xz v0.5.12 // indirect; indirect from boilerplate
	github.com/urfave/cli/v2 v2.27.5 // indirect; indirect from boilerplate
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect; indirect from boilerplate
	github.com/xrash/smetrics v0.0.0-20240521201337-686a1a2994c1 // indirect; indirect from boilerplate
	go.opencensus.io v0.24.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/detectors/gcp v1.31.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.56.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.56.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel v1.31.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/metric v1.31.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/sdk v1.31.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/sdk/metric v1.31.0 // indirect; indirect from boilerplate
	go.opentelemetry.io/otel/trace v1.31.0 // indirect; indirect from boilerplate
	golang.org/x/arch v0.21.0 // indirect
	golang.org/x/crypto v0.42.0 // indirect; indirect from boilerplate
	golang.org/x/net v0.44.0 // indirect; indirect from boilerplate
	golang.org/x/oauth2 v0.27.0 // indirect; indirect from boilerplate
	golang.org/x/sync v0.17.0 // indirect; indirect from boilerplate
	golang.org/x/sys v0.36.0 // indirect; indirect from boilerplate
	golang.org/x/term v0.35.0 // indirect; indirect from boilerplate
	golang.org/x/text v0.29.0 // indirect; indirect from boilerplate
	golang.org/x/time v0.7.0 // indirect; indirect from boilerplate
	google.golang.org/api v0.200.0 // indirect; indirect from boilerplate
	google.golang.org/genproto v0.0.0-20241007155032-5fefd90f89a9 // indirect; indirect from boilerplate
	google.golang.org/genproto/googleapis/api v0.0.0-20241007155032-5fefd90f89a9 // indirect; indirect from boilerplate
	google.golang.org/genproto/googleapis/rpc v0.0.0-20241007155032-5fefd90f89a9 // indirect; indirect from boilerplate
	google.golang.org/grpc v1.67.1 // indirect; indirect from boilerplate
	google.golang.org/grpc/stats/opentelemetry v0.0.0-20241014145745-ad81c20503be // indirect; indirect from boilerplate
	google.golang.org/protobuf v1.36.9 // indirect; indirect from boilerplate
	gopkg.in/yaml.v2 v2.4.0 // indirect; indirect from boilerplate
	gopkg.in/yaml.v3 v3.0.1 // indirect from boilerplate
	sigs.k8s.io/yaml v1.4.0 // indirect; indirect from boilerplate
)

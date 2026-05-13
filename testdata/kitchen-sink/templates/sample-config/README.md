# {{ .app_name }} Configuration

Generated configuration for **{{ .app_name }}** on port {{ .port }}.

{{ if .enable_tls -}}
TLS is **enabled**.
{{- else -}}
TLS is **disabled**.
{{- end }}

Log level: `{{ .log_level }}`

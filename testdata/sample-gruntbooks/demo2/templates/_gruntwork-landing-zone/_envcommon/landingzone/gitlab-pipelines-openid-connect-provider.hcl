inputs = {
  {{- if eq .inputs.CustomSCMProviderInstanceURL "" }}
  audiences = [
    "https://gitlab.com/{{ .inputs.SCMProviderGroup }}",
  ]
  {{- else }}
  audiences = [
    "{{ .inputs.CustomSCMProviderInstanceURL }}/{{ .inputs.SCMProviderGroup }}",
  ]
  URL = "{{ .inputs.CustomSCMProviderInstanceURL }}"
  {{- end }}
}

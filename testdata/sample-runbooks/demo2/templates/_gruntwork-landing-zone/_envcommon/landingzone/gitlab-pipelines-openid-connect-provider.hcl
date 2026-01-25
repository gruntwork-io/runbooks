inputs = {
  {{- if eq .CustomSCMProviderInstanceURL "" }}
  audiences = [
    "https://gitlab.com/{{ .SCMProviderGroup }}",
  ]
  {{- else }}
  audiences = [
    "{{ .CustomSCMProviderInstanceURL }}/{{ .SCMProviderGroup }}",
  ]
  URL = "{{ .CustomSCMProviderInstanceURL }}"
  {{- end }}
}

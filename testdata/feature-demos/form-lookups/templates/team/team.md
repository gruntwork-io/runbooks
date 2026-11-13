# {{ .TeamName }}

- Organization: {{ .Domain }}
- Lead: {{ .Lead }}
- Members:{{ range .Members }}
  - {{ . }}{{ end }}

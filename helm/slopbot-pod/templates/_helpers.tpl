{{/* slopbot-pod helpers — labels/naming, mirroring the namazu-agent chart's conventions. */}}

{{- define "slopbot-pod.name" -}}
slopbot-pod
{{- end }}

{{- define "slopbot-pod.fullname" -}}
{{ include "slopbot-pod.name" . }}
{{- end }}

{{- define "slopbot-pod.labels" -}}
app.kubernetes.io/name: {{ include "slopbot-pod.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.Version | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
slopbot.ai/component: agent-pod
{{- end }}

{{- /* Fail loud on a nil/empty required value (#92's convention): a nulled
values entry would render as the literal "null" or an empty string — a
half-configured pod, exactly what the fail-loud convention exists to stop. */}}
{{- define "slopbot-pod.reqNotNil" -}}
{{- $name := index . 0 -}}
{{- $value := index . 1 -}}
{{- if kindIs "invalid" $value -}}
{{- fail (printf "%s must be set (got nil — a deployment values file nulled it; see #92)" $name) -}}
{{- end -}}
{{- $value -}}
{{- end }}

{{- define "sa.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sa.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "sa.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sa.labels" -}}
app.kubernetes.io/name: {{ include "sa.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "sa.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sa.name" . }}
{{- end -}}

{{- define "sa.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "sa.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "sa.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "sa.fullname" .) -}}
{{- end -}}
{{- end -}}

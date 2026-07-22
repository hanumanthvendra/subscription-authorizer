#!/usr/bin/env bash
# Validates the Prometheus alert rules and the Helm chart.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== promtool: alert rules =="
docker run --rm --entrypoint promtool -v "$ROOT/prometheus":/rules prom/prometheus:v2.54.1 check rules /rules/alerts.yml
echo
echo "== helm lint =="
helm lint "$ROOT/helm/subscription-authorizer"
echo
echo "== helm template: resources rendered =="
helm template demo "$ROOT/helm/subscription-authorizer" \
  --set monitoring.serviceMonitor.enabled=true --set monitoring.prometheusRule.enabled=true \
  | grep -c '^kind:' | xargs echo "kubernetes resources rendered:"

#!/usr/bin/env bash
# Create a local kind cluster and apply all manifests for the sandbox pool.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-pi-sandbox}"

if ! command -v kind >/dev/null; then
  echo "kind is required: https://kind.sigs.k8s.io/docs/user/quick-start/#installation" >&2
  exit 1
fi

if ! kind get clusters | grep -qx "$CLUSTER"; then
  echo ">> creating kind cluster: $CLUSTER"
  kind create cluster --name "$CLUSTER"
fi

echo ">> applying manifests"
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/10-rbac.yaml
kubectl apply -f k8s/20-leases.yaml
kubectl apply -f k8s/30-sandbox-statefulset.yaml

echo ">> waiting for the 8 sandbox pods to be Ready"
kubectl -n pi-sandbox rollout status statefulset/sandbox-runner --timeout=120s

echo ">> sandbox pool:"
kubectl -n pi-sandbox get pods -l app=sandbox-runner
kubectl -n pi-sandbox get leases

echo ">> done. Run the API locally with:  npm run dev"

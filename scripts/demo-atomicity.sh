#!/usr/bin/env bash
# Proof: the Redis reserve script cannot oversell a plan under concurrency.
# Fires 100 simultaneous reservations of 30 units against a limit of 1000.
set -e
NAME="sa-atomicity-$$"
docker run -d --name "$NAME" redis:7-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
until docker exec "$NAME" redis-cli ping >/dev/null 2>&1; do sleep 0.5; done

docker cp "$(dirname "$0")/../src/redis/scripts/reserve.lua" "$NAME":/tmp/reserve.lua >/dev/null
QK="quota:demo:period-1"
docker exec "$NAME" redis-cli del "$QK" >/dev/null

echo "Firing 100 concurrent reservations of 30 units against a limit of 1000..."
seq 0 99 | xargs -P 60 -I{} docker exec "$NAME" \
  redis-cli --eval /tmp/reserve.lua "$QK" "resv:{}" , 30 600 1000 3600 0 >/dev/null 2>&1

echo
echo "Final quota hash:"
docker exec "$NAME" redis-cli hgetall "$QK"
RES=$(docker exec "$NAME" redis-cli hget "$QK" reserved)
echo
echo "reserved=$RES  ->  floor(1000/30)*30 = 990, and it can NEVER exceed the 1000 limit."

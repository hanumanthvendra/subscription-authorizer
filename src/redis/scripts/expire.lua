-- expire.lua — release an abandoned reservation (driven by the expiry worker,
-- which selects reservations past expires_at from PostgreSQL as the source of truth).
-- Semantically identical to release, but records reason 'expired'.
-- KEYS[1] = quota hash
-- KEYS[2] = reservation marker
-- Returns: { ok(1/0), remaining, reason }

local q      = KEYS[1]
local marker = KEYS[2]

local function remaining()
  local v = redis.call('HMGET', q, 'limit', 'consumed', 'reserved')
  return (tonumber(v[1]) or 0) - (tonumber(v[2]) or 0) - (tonumber(v[3]) or 0)
end

if redis.call('EXISTS', marker) == 0 then
  return { 1, remaining(), 'idempotent' }
end

local state    = redis.call('HGET', marker, 'state')
local reserved = tonumber(redis.call('HGET', marker, 'units')) or 0

if state ~= 'reserved' then
  return { 1, remaining(), 'noop' }
end

redis.call('HINCRBY', q, 'reserved', -reserved)
redis.call('HSET', marker, 'state', 'expired')
return { 1, remaining(), 'expired' }

-- release.lua — return a reserved (unsettled) hold to the pool.
-- KEYS[1] = quota hash
-- KEYS[2] = reservation marker
-- ARGV[1] = marker retention seconds (keep released marker for idempotency)
-- Returns: { ok(1/0), remaining, reason }

local q      = KEYS[1]
local marker = KEYS[2]
local keep   = tonumber(ARGV[1])

local function remaining()
  local v = redis.call('HMGET', q, 'limit', 'consumed', 'reserved')
  return (tonumber(v[1]) or 0) - (tonumber(v[2]) or 0) - (tonumber(v[3]) or 0)
end

-- No marker => already released/expired. Treat as success (idempotent).
if redis.call('EXISTS', marker) == 0 then
  return { 1, remaining(), 'idempotent' }
end

local state    = redis.call('HGET', marker, 'state')
local reserved = tonumber(redis.call('HGET', marker, 'units')) or 0

if state == 'released' then
  return { 1, remaining(), 'idempotent' }
end
if state == 'committed' then
  return { 0, remaining(), 'already_committed' }
end

redis.call('HINCRBY', q, 'reserved', -reserved)
redis.call('HSET', marker, 'state', 'released')
if keep > 0 then redis.call('EXPIRE', marker, keep) end

return { 1, remaining(), 'released' }

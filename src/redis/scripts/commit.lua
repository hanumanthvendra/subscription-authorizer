-- commit.lua — settle a reservation: move actual units to consumed, release the rest.
-- KEYS[1] = quota hash
-- KEYS[2] = reservation marker
-- ARGV[1] = actual units
-- ARGV[2] = overage allowance (units permitted above the reserved amount)
-- ARGV[3] = marker retention seconds (keep committed marker for idempotency)
-- Returns: { ok(1/0), remaining, committedUnits, reason }

local q      = KEYS[1]
local marker = KEYS[2]
local actual  = tonumber(ARGV[1])
local overage = tonumber(ARGV[2])
local keep    = tonumber(ARGV[3])

if redis.call('EXISTS', marker) == 0 then
  -- Marker gone (expired/released by worker). Caller must handle the late-commit path
  -- against PostgreSQL; Redis cannot safely settle without the reserved amount.
  return { 0, -1, 0, 'reservation_not_found' }
end

local state    = redis.call('HGET', marker, 'state')
local reserved = tonumber(redis.call('HGET', marker, 'units')) or 0

local function remaining()
  local v = redis.call('HMGET', q, 'limit', 'consumed', 'reserved')
  return (tonumber(v[1]) or 0) - (tonumber(v[2]) or 0) - (tonumber(v[3]) or 0)
end

if state == 'committed' then
  local prev = tonumber(redis.call('HGET', marker, 'committed')) or 0
  return { 1, remaining(), prev, 'idempotent' }
end
if state ~= 'reserved' then
  return { 0, remaining(), 0, 'not_reservable' }
end

local cap = reserved + overage
local commitUnits = actual
local reason = 'committed'
if commitUnits > cap then
  commitUnits = cap
  reason = 'capped'
end
if commitUnits < 0 then commitUnits = 0 end

-- release the whole hold, then charge the actual (capped) usage
redis.call('HINCRBY', q, 'reserved', -reserved)
redis.call('HINCRBY', q, 'consumed', commitUnits)
redis.call('HSET', marker, 'state', 'committed', 'committed', commitUnits)
if keep > 0 then redis.call('EXPIRE', marker, keep) end

return { 1, remaining(), commitUnits, reason }

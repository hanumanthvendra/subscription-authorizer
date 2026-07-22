-- reserve.lua — atomically reserve estimated units for one reservation.
-- KEYS[1] = quota hash   quota:{tenantId}:{period}   fields: limit, consumed, reserved
-- KEYS[2] = reservation marker   resv:{reservationId}
-- ARGV[1] = estimated units (integer >= 0)
-- ARGV[2] = reservation TTL seconds (marker expiry)
-- ARGV[3] = seed limit (used only if the quota hash does not yet exist)
-- ARGV[4] = period TTL seconds for the quota hash (0 = no expiry)
-- ARGV[5] = seed consumed (Postgres points_consumed, used only on first seed)
-- Returns: { ok(1/0), remaining, reason }

local q      = KEYS[1]
local marker = KEYS[2]
local est    = tonumber(ARGV[1])
local rttl   = tonumber(ARGV[2])
local seed   = tonumber(ARGV[3])
local pttl   = tonumber(ARGV[4])
local seedConsumed = tonumber(ARGV[5]) or 0

-- Idempotency: a marker already exists for this reservation id -> return as-is.
if redis.call('EXISTS', marker) == 1 then
  local rem = tonumber(redis.call('HGET', marker, 'remaining')) or 0
  return { 1, rem, 'idempotent' }
end

-- Seed the quota hash on first use of the period.
if redis.call('EXISTS', q) == 0 then
  redis.call('HSET', q, 'limit', seed, 'consumed', seedConsumed, 'reserved', 0)
  if pttl > 0 then redis.call('EXPIRE', q, pttl) end
end

local vals     = redis.call('HMGET', q, 'limit', 'consumed', 'reserved')
local limit    = tonumber(vals[1]) or 0
local consumed = tonumber(vals[2]) or 0
local reserved = tonumber(vals[3]) or 0
local remaining = limit - consumed - reserved

if remaining < est then
  return { 0, remaining, 'quota_exhausted' }
end

redis.call('HINCRBY', q, 'reserved', est)
redis.call('HSET', marker, 'units', est, 'remaining', remaining - est, 'state', 'reserved')
if rttl > 0 then redis.call('EXPIRE', marker, rttl) end

return { 1, remaining - est, 'reserved' }

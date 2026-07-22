-- consume.lua — apply actual usage directly to `consumed`, bounded by the cap.
-- Used for the late-commit path (marker already released/expired, spec §9) where there
-- is no hold to convert. Never lets consumed+reserved exceed limit + overage.
-- KEYS[1] = quota hash
-- ARGV[1] = units to add
-- ARGV[2] = overage allowance
-- Returns: { appliedUnits, remaining, capped(1/0) }

local q       = KEYS[1]
local add     = tonumber(ARGV[1])
local overage = tonumber(ARGV[2])

local v        = redis.call('HMGET', q, 'limit', 'consumed', 'reserved')
local limit    = tonumber(v[1]) or 0
local consumed = tonumber(v[2]) or 0
local reserved = tonumber(v[3]) or 0

local allowed = (limit + overage) - consumed - reserved
if allowed < 0 then allowed = 0 end

local applied = add
local capped = 0
if applied > allowed then applied = allowed; capped = 1 end
if applied < 0 then applied = 0 end

redis.call('HINCRBY', q, 'consumed', applied)
local remaining = limit - (consumed + applied) - reserved
return { applied, remaining, capped }

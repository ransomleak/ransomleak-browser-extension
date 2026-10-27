# RLBF1: NRD Bloom filter wire format

Contract between the extension reader (`src/detect/bloom.ts`) and the backend publisher.
Reference writer: `scripts/bloom-write.mjs`. Fixture: `test/fixtures/sample-domains.txt` ->
`test/fixtures/sample.rlbf` (built with target FP 0.001). The backend MUST reproduce the fixture byte-for-byte.

## Layout

| Offset | Size | Field |
|---|---|---|
| 0 | 5 | ASCII `RLBF1` (`52 4C 42 46 31`) |
| 5 | 4 | `m`, number of bits, uint32 **little-endian**; multiple of 8, >= 8 |
| 9 | 1 | `k`, number of hash functions, uint8, 1..32 |
| 10 | m/8 | bit array |

Total length is exactly `10 + m/8`. Bit `j` lives in byte `10 + (j >> 3)` at mask `1 << (j & 7)` (LSB-first).
Readers reject: bad header, length < 10, `m` = 0 or not a multiple of 8, `k` = 0 or > 32, length != `10 + m/8`.

## Keys

The lowercase registrable domain (eTLD+1), encoded as UTF-8 bytes. IDNs must already be punycode (ASCII)
before lookup or writing; the reader does not convert. The reader's `has()` lowercases its input but does NOT trim.
Writer input: one domain per line; blank lines and lines starting with `#` ignored; lowercased and de-duplicated.

## Hashing

- `h1` = FNV-1a 32-bit: start `0x811C9DC5`; for each byte `h ^= b; h = (h * 0x01000193) mod 2^32`.
- `h2` = MurmurHash3 x86_32, seed 0 (standard algorithm, little-endian 4-byte blocks, tail, `h ^= len`, fmix32).
- For `i` in `0..k-1`: `index_i = ((h1 + i*h2) mod 2^32) mod m` (unsigned 32-bit wraparound, then modulo `m`).
  In JS: `((h1 + Math.imul(i, h2)) >>> 0) % m`.

## Sizing

Given `n` unique keys (use `max(n,1)`) and target false-positive rate `p`, using IEEE-754 doubles:

- `raw = ceil(-n * ln(p) / (ln 2)^2)`, then `m = ceil(raw / 8) * 8` (minimum 8).
- `k = floor((m / n) * ln 2 + 0.5)` (round half UP; do not use Python's `round`, which is banker's), clamped to `[1, 32]`.

Expected integers (assert yours against these):

| n | p | raw | m | k | (m/n)·ln2 |
|---|---|---|---|---|---|
| 1000 | 0.001 | 14378 | 14384 | 10 | 9.9702 |
| 150000 | 0.001 | 2156639 | 2156640 | 10 | 9.9658 |
| 5000000 | 0.001 | 71887938 | 71887944 | 10 | 9.9658 |
| 1 | 0.001 | 15 | 16 | 11 | 11.0904 |
| 7 | 0.01 | 68 | 72 | 7 | 7.1295 |
| 1000 | 0.00552 | 10822 | 10824 | 8 | 7.5026 (near half) |

The fixture uses n = 1000, p = 0.001: m = 14384, k = 10, file length 1808 bytes.

## Test vectors

| Key | h1 (FNV-1a) | h2 (Murmur3, seed 0) |
|---|---|---|
| `example-new.com` | 1044708521 | 3947312074 |
| `a.io` | 2406334646 | 1379151513 |
| `ransomleak.com` | 465442287 | 268822097 |

Primitive sanity checks: murmur3("hello", 0) = `0x248BFA47`; fnv1a("a") = `0xE40C292C`;
fnv1a("") = `0x811C9DC5`; murmur3("") = `0`.

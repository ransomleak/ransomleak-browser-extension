# RLHS2 hashed-prefix set

Wire format of the popularity allowlist (`policy.popular.url`, served at
`/api/browser-ext/feeds/popular/<version>`). Reader: `src/detect/hashset.ts`;
test writer: `scripts/hashset-write.mjs`. The backend must emit exactly this.

| Offset | Size | Field |
|--------|------|-------|
| 0 | 5 | ASCII `RLHS2` |
| 5 | 4 | `n`, uint32 little-endian |
| 9 | 16 × n | entries |

Each entry is the first 16 bytes of SHA-256 over the UTF-8 bytes of the
lowercased registrable domain (punycode/ASCII form), in big-endian byte order
(the digest's natural byte order). Entries are sorted ascending (unsigned,
bytewise) and unique. The total length must be exactly `9 + 16n`.

A reader rejects a bad magic, a length mismatch, or unsorted/duplicate entries
(`HashSetFormatError`); a rejected file keeps the previous set (or none, which
means no exemption). Lookup is a binary search comparing four uint32 words.

Why not a Bloom filter: a public Bloom lets an attacker search for a lookalike
name that collides with set bits. Finding a name whose 128-bit SHA-256 prefix
matches one of 100k entries costs about 2^96 hashes per hit.

## Test vectors

| Domain | Entry (hex) |
|--------|-------------|
| `google.com` | `d4c9d9027326271a89ce51fcaf328ed6` |
| `Example.COM` (hashed as `example.com`) | `a379a6f6eeafb9a55e378c118034e275` |
| `xn--80ak6aa92e.com` | `dc7b4e6ffcc676f053589c2b8f8922f7` |
| `example-new.com` | `90e340f231294b39801fe713cd2d18e1` |
| `a.io` | `0df92fb080b9111416f49b4b42d0be1a` |
| `ransomleak.com` | `3855835fe23ddd3ac1afd75dfba305a3` |

Recompute any vector with `printf %s <domain> | shasum -a 256 | cut -c1-32`.

A file holding `example-new.com`, `a.io` and `ransomleak.com` (entries sorted
ascending: `a.io`, `ransomleak.com`, `example-new.com`) is exactly:

```
524c485332 03000000
0df92fb080b9111416f49b4b42d0be1a
3855835fe23ddd3ac1afd75dfba305a3
90e340f231294b39801fe713cd2d18e1
```

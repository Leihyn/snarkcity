use std::io::Read;

use orchard::keys::{FullViewingKey, SpendValidatingKey, SpendingKey};

fn random_32() -> [u8; 32] {
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("read /dev/urandom");
    b
}

/// Generate an Orchard `FullViewingKey` whose `ak` is the given FROST group key.
///
/// Same derivation as upstream zcash-sign (`from_sk_ak_incompatible_with_quantum_recoverability...`
/// from the conradoplg orchard patch): nk and rivk come from a fresh random `sk`, ak is replaced.
/// orchard 0.16 has no such constructor, but `FullViewingKey::from_bytes(ak || nk || rivk)` is
/// public and yields the identical key, so no orchard patch is needed.
/// NOT quantum-recoverable (ZIP 2005); experimental use only.
pub fn generate(ak: &SpendValidatingKey) -> FullViewingKey {
    loop {
        let sk = SpendingKey::from_bytes(random_32());
        if bool::from(sk.is_none()) {
            continue;
        }
        let sk = sk.unwrap();
        let mut bytes = FullViewingKey::from(&sk).to_bytes();
        bytes[..32].copy_from_slice(&ak.to_bytes());
        // from_bytes rejects degenerate keys (e.g. ivk = 0); retry with a new sk then.
        if let Some(fvk) = FullViewingKey::from_bytes(&bytes) {
            return fvk;
        }
    }
}

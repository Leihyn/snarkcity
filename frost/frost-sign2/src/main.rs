//! In-process 2-of-N rerandomized FROST (RedPallas) signer for Zcash spends.
//! Usage: frost-sign2 <cfg1.toml> <cfg2.toml> <group_pubkey_hex> <sighash_hex> <alpha_hex>
//! Prints ONLY the 64-byte aggregated signature (hex). Never prints key material.
use std::collections::BTreeMap;
use frost_rerandomized::{RandomizedParams, Randomizer};
use reddsa::frost::redpallas::PallasBlake2b512 as C;
use frost_core::{round1, SigningPackage, keys::{KeyPackage, PublicKeyPackage}};

fn field(cfg: &str, group: &str, key: &str) -> Vec<u8> {
    let text = std::fs::read_to_string(cfg).expect("read config");
    let header = format!("[group.{group}]");
    let mut in_group = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') { in_group = l == header; continue; }
        if in_group {
            if let Some(rest) = l.strip_prefix(&format!("{key} = ")) {
                return hex::decode(rest.trim().trim_matches('"')).expect("hex field");
            }
        }
    }
    panic!("field {key} not found in {cfg}");
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    assert_eq!(a.len(), 6, "usage: frost-sign2 cfg1 cfg2 group sighash alpha");
    let (group, msg) = (&a[3], hex::decode(&a[4]).expect("sighash hex"));
    let randomizer = Randomizer::<C>::deserialize(&hex::decode(&a[5]).expect("alpha hex")).expect("alpha");
    let pkp: PublicKeyPackage<C> = postcard::from_bytes(&field(&a[1], group, "public_key_package")).unwrap();
    let kps: Vec<KeyPackage<C>> = [&a[1], &a[2]].iter()
        .map(|c| postcard::from_bytes(&field(c, group, "key_package")).unwrap()).collect();
    let mut rng = rand::thread_rng();
    let mut nonces = BTreeMap::new();
    let mut comms = BTreeMap::new();
    for kp in &kps {
        let (n, c) = round1::commit(kp.signing_share(), &mut rng);
        nonces.insert(*kp.identifier(), n);
        comms.insert(*kp.identifier(), c);
    }
    let sp = SigningPackage::new(comms, &msg);
    let mut shares = BTreeMap::new();
    for kp in &kps {
        let s = frost_rerandomized::sign::<C>(&sp, &nonces[kp.identifier()], kp, randomizer).expect("sign");
        shares.insert(*kp.identifier(), s);
    }
    let params = RandomizedParams::<C>::from_randomizer(pkp.verifying_key(), randomizer);
    let sig = frost_rerandomized::aggregate::<C>(&sp, &shares, &pkp, &params).expect("aggregate");
    params.randomized_verifying_key().verify(&msg, &sig).expect("verify under rk");
    eprintln!("verified under randomized key rk={}", hex::encode(params.randomized_verifying_key().serialize().unwrap()));
    println!("{}", hex::encode(sig.serialize().unwrap()));
}

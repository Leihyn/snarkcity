use std::{error::Error, fs};

use clap::{Parser, Subcommand};
use eyre::eyre;
use orchard::keys::{Scope, SpendValidatingKey};
use pczt::Pczt;
use zcash_keys::{address::UnifiedAddress, keys::UnifiedFullViewingKey};
use zcash_protocol::consensus::Network;

#[derive(Parser)]
#[command(version, about = "zcash-sign ported to librustzcash eb38d7a (NU7 testnet)")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a UFVK + address from a FROST group verifying key (ak).
    Generate {
        #[arg(short, long)]
        ak: String,
        #[arg(short, long, default_value = "main")]
        network: String,
    },
    /// Sign a PCZT with externally-generated signatures.
    Sign {
        #[arg(short = 'i', long)]
        tx_plan: String,
        #[arg(short = 'o', long)]
        tx: String,
        #[arg(short, long, default_value = "main")]
        network: String,
    },
}

fn net(s: &str) -> Result<Network, Box<dyn Error>> {
    match s {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        _ => Err(eyre!("Invalid network: {s}").into()),
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    match Args::parse().command {
        Command::Generate { ak, network } => {
            let params = net(&network)?;
            let ak = hex::decode(ak.trim())?;
            let ak = SpendValidatingKey::from_bytes(&ak).ok_or(eyre!("Invalid ak"))?;
            let fvk = zcash_sign_nu7::generate(&ak);
            let addr = fvk.address_at(0u64, Scope::External);
            let ua = UnifiedAddress::from_receivers(Some(addr), None, None, None, None)
                .ok_or(eyre!("UA construction failed"))?;
            println!("Orchard-only unified address: {}", ua.encode(&params));
            let ufvk = UnifiedFullViewingKey::from_orchard_fvk(fvk)
                .map_err(|e| eyre!("UFVK: {e:?}"))?;
            println!("Unified Full Viewing Key: {}", ufvk.encode(&params).map_err(|e| eyre!("UFVK encode: {e:?}"))?);
        }
        Command::Sign { tx_plan, tx, network } => {
            let _ = net(&network)?;
            let bytes = fs::read(&tx_plan)?;
            let pczt = Pczt::parse(&bytes).map_err(|e| eyre!("PCZT parse: {e:?}"))?;
            let out = zcash_sign_nu7::sign(&pczt)?;
            fs::write(&tx, out)?;
            println!("Tx written to {tx}");
        }
    }
    Ok(())
}

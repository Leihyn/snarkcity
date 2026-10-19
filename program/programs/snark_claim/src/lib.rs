// SnarkCity claim program.
//
// A launch's tokens sit in a vault owned by the launch account. After the
// sealed auction closes on Zcash, the creator posts the allocation root. Each
// winning bidder then claims with the fresh ed25519 key they committed to in
// their bid memo: the program checks that sha256(claim key || salt) is the
// committed value and that the allocation proves against the root. A receipt
// account per commitment blocks double claims. Anyone can pay the fees (the
// launchpad relays), but only the claim key's signature authorises a claim, so
// the relayer cannot redirect tokens.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod merkle;

declare_id!("WA7VpLkfVh5HhCdfxHPosru9FEbTyUJUwUZhEkqe4Fu");

/// Root posted when an auction closes with nothing sold. No leaf can hash to
/// it, so nothing is claimable, and it unlocks the full supply for withdrawal.
pub const NO_SALE_ROOT: [u8; 32] = [0xff; 32];

#[program]
pub mod snark_claim {
    use super::*;

    pub fn create_launch(ctx: Context<CreateLaunch>, launch_id: u64, supply: u64) -> Result<()> {
        require!(supply > 0, ClaimError::ZeroSupply);
        let launch = &mut ctx.accounts.launch;
        launch.creator = ctx.accounts.creator.key();
        launch.mint = ctx.accounts.mint.key();
        launch.launch_id = launch_id;
        launch.supply = supply;
        launch.root = [0; 32];
        launch.allocated = 0;
        launch.claimed = 0;
        launch.unsold_withdrawn = false;
        launch.bump = ctx.bumps.launch;
        let cpi = Transfer {
            from: ctx.accounts.creator_token.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi), supply)
    }

    pub fn set_root(ctx: Context<SetRoot>, root: [u8; 32], allocated: u64) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(launch.root == [0; 32], ClaimError::RootAlreadySet);
        require!(root != [0; 32] && root != NO_SALE_ROOT, ClaimError::EmptyRoot);
        require!(allocated <= launch.supply, ClaimError::OverAllocated);
        launch.root = root;
        launch.allocated = allocated;
        Ok(())
    }

    /// For an auction where nothing sold: finalizes the launch with no
    /// allocations so the creator can withdraw the whole supply.
    pub fn close_without_sale(ctx: Context<SetRoot>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(launch.root == [0; 32], ClaimError::RootAlreadySet);
        launch.root = NO_SALE_ROOT;
        launch.allocated = 0;
        Ok(())
    }

    pub fn claim(
        ctx: Context<Claim>,
        commitment: [u8; 32],
        salt: [u8; 16],
        tokens: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(launch.root != [0; 32], ClaimError::RootNotSet);
        require!(launch.root != NO_SALE_ROOT, ClaimError::NoSale);
        let expected = merkle::commitment(&ctx.accounts.claimer.key().to_bytes(), &salt);
        require!(expected == commitment, ClaimError::WrongClaimKey);
        let leaf = merkle::leaf(&commitment, tokens);
        require!(merkle::verify(leaf, &proof, &launch.root), ClaimError::InvalidProof);
        let claimed = launch.claimed.checked_add(tokens).ok_or(ClaimError::OverAllocated)?;
        require!(claimed <= launch.allocated, ClaimError::OverAllocated);
        pay_from_vault(&ctx.accounts.launch, &ctx.accounts.vault, &ctx.accounts.recipient_token, &ctx.accounts.token_program, tokens)?;
        ctx.accounts.launch.claimed = claimed;
        Ok(())
    }

    pub fn withdraw_unsold(ctx: Context<WithdrawUnsold>) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(launch.root != [0; 32], ClaimError::RootNotSet);
        require!(!launch.unsold_withdrawn, ClaimError::AlreadyWithdrawn);
        let unsold = launch.supply - launch.allocated;
        pay_from_vault(&ctx.accounts.launch, &ctx.accounts.vault, &ctx.accounts.creator_token, &ctx.accounts.token_program, unsold)?;
        ctx.accounts.launch.unsold_withdrawn = true;
        Ok(())
    }
}

fn pay_from_vault<'info>(
    launch: &Account<'info, Launch>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let id = launch.launch_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"launch", launch.creator.as_ref(), &id, &[launch.bump]];
    let cpi = Transfer {
        from: vault.to_account_info(),
        to: to.to_account_info(),
        authority: launch.to_account_info(),
    };
    token::transfer(CpiContext::new_with_signer(token_program.to_account_info(), cpi, &[seeds]), amount)
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub launch_id: u64,
    pub supply: u64,
    pub root: [u8; 32],
    pub allocated: u64,
    pub claimed: u64,
    pub unsold_withdrawn: bool,
    pub bump: u8,
}

/// Exists once a commitment has claimed; its presence blocks a second claim.
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {}

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token: Account<'info, TokenAccount>,
    #[account(
        init, payer = creator, space = 8 + Launch::INIT_SPACE,
        seeds = [b"launch", creator.key().as_ref(), &launch_id.to_le_bytes()], bump
    )]
    pub launch: Account<'info, Launch>,
    #[account(
        init, payer = creator, token::mint = mint, token::authority = launch,
        seeds = [b"vault", launch.key().as_ref()], bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRoot<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub launch: Account<'info, Launch>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct Claim<'info> {
    /// Pays fees and rent; usually the launchpad's relayer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The fresh key committed to in the bid memo.
    pub claimer: Signer<'info>,
    #[account(mut)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = launch.mint)]
    pub recipient_token: Account<'info, TokenAccount>,
    #[account(
        init, payer = payer, space = 8 + ClaimReceipt::INIT_SPACE,
        seeds = [b"claimed", launch.key().as_ref(), &commitment], bump
    )]
    pub receipt: Account<'info, ClaimReceipt>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawUnsold<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = launch.mint)]
    pub creator_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ClaimError {
    #[msg("Supply must be greater than zero")]
    ZeroSupply,
    #[msg("The allocation root is already set")]
    RootAlreadySet,
    #[msg("The allocation root cannot be empty")]
    EmptyRoot,
    #[msg("The allocation root is not set yet")]
    RootNotSet,
    #[msg("Allocated tokens exceed the launch supply")]
    OverAllocated,
    #[msg("The signer is not the key committed to in the bid")]
    WrongClaimKey,
    #[msg("The allocation does not prove against the root")]
    InvalidProof,
    #[msg("Unsold tokens were already withdrawn")]
    AlreadyWithdrawn,
    // New variants go last so existing error codes keep their numbers.
    #[msg("The launch closed without a sale; nothing is claimable")]
    NoSale,
}

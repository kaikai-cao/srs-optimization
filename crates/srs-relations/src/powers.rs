use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::PrimeField;
use ark_std::UniformRand;
use ark_std::rand::{SeedableRng, rngs::StdRng};

pub const DEFAULT_N: usize = 32;

/// Trapdoor scalars. These exist ONLY inside the `gen` process. They are never
/// serialized, printed, written to a file, or passed to a recovery API.
/// (No "secure zeroization" claim is made: the process simply exits.)
#[allow(dead_code)]
pub struct SecretScalars {
    pub tau: Fr,
    pub alpha: Fr,
    pub beta: Fr,
}

#[derive(Clone, Debug)]
pub struct TestSrs {
    pub n: usize,
    /// P_i = [tau^i] G1 for 0 <= i <= 2N-2  (2N-1 points)
    pub tau_g1: Vec<G1Affine>,
    /// Q_i = [tau^i] G2 for 0 <= i <= N-1
    pub tau_g2: Vec<G2Affine>,
    /// A_i = [alpha*tau^i] G1
    pub alpha_tau_g1: Vec<G1Affine>,
    /// B_i = [beta*tau^i] G1
    pub beta_tau_g1: Vec<G1Affine>,
    /// B_2 = [beta] G2
    pub beta_g2: G2Affine,
}

fn nonzero_scalar(rng: &mut StdRng) -> Fr {
    loop {
        let s = Fr::rand(rng);
        if s != Fr::from(0u64) {
            return s;
        }
    }
}

fn generate_from_seed(n: usize, seed: [u8; 32]) -> (SecretScalars, TestSrs) {
    assert!(n >= 2, "N must be at least 2");
    let mut rng = StdRng::from_seed(seed);
    let tau = nonzero_scalar(&mut rng);
    let alpha = nonzero_scalar(&mut rng);
    let beta = nonzero_scalar(&mut rng);

    let g1 = G1Projective::generator();
    let g2 = G2Projective::generator();

    let mut coeff = Fr::from(1u64);
    let mut tau_g1 = Vec::with_capacity(2 * n - 1);
    for _ in 0..(2 * n - 1) {
        let p = g1.mul_bigint(coeff.into_bigint());
        tau_g1.push(p.into_affine());
        coeff *= tau;
    }

    let mut coeff = Fr::from(1u64);
    let mut tau_g2 = Vec::with_capacity(n);
    for _ in 0..n {
        let p = g2.mul_bigint(coeff.into_bigint());
        tau_g2.push(p.into_affine());
        coeff *= tau;
    }

    let mut coeff = Fr::from(1u64);
    let mut alpha_tau_g1 = Vec::with_capacity(n);
    let mut beta_tau_g1 = Vec::with_capacity(n);
    for _ in 0..n {
        let ac = alpha * coeff;
        let bc = beta * coeff;
        alpha_tau_g1.push(g1.mul_bigint(ac.into_bigint()).into_affine());
        beta_tau_g1.push(g1.mul_bigint(bc.into_bigint()).into_affine());
        coeff *= tau;
    }

    let beta_g2 = g2.mul_bigint(beta.into_bigint()).into_affine();

    (
        SecretScalars { tau, alpha, beta },
        TestSrs {
            n,
            tau_g1,
            tau_g2,
            alpha_tau_g1,
            beta_tau_g1,
            beta_g2,
        },
    )
}

/// FORMAL-EXPERIMENT generator (R1).
///
/// The 32-byte seed is drawn directly from the OS entropy source
/// (`getrandom`; on Windows -> BCryptGenRandom). It is a local variable that
/// is never returned, printed, or persisted, and it disappears when the
/// `gen` process exits. Consequently nobody reading the public repository,
/// the public parameter files, or the reports can reconstruct tau/alpha/beta.
///
/// NOTE: `ark_std::rand` is built with `default-features = false` by arkworks
/// 0.6.0, so `OsRng` / `StdRng::from_entropy` are NOT available there; we use
/// `getrandom` explicitly instead.
pub fn generate_from_os_entropy(n: usize) -> (SecretScalars, TestSrs) {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("OS entropy source unavailable");
    generate_from_seed(n, seed)
}

// ---------------------------------------------------------------------------
// TEST-ONLY deterministic generator. The seed below is NOT compiled into the
// release binaries used for the formal experiment (cfg(test)); it exists only
// to make unit tests reproducible. Keep it out of any formal-experiment path.
// ---------------------------------------------------------------------------
#[cfg(test)]
const TEST_SEED: [u8; 32] = [
    0x53, 0x52, 0x53, 0x2d, 0x4d, 0x32, 0x2d, 0x54, 0x45, 0x53, 0x54, 0x2d, 0x53, 0x45, 0x45, 0x44,
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];

#[cfg(test)]
pub fn generate_for_tests(n: usize) -> (SecretScalars, TestSrs) {
    generate_from_seed(n, TEST_SEED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::AffineRepr;

    #[test]
    fn deterministic_and_correct_lengths() {
        let (_, a) = generate_for_tests(8);
        let (_, b) = generate_for_tests(8);
        assert_eq!(a.tau_g1.len(), 15);
        assert_eq!(a.tau_g2.len(), 8);
        assert_eq!(a.alpha_tau_g1.len(), 8);
        assert_eq!(a.beta_tau_g1.len(), 8);
        assert_eq!(a.tau_g1, b.tau_g1);
        assert_eq!(a.tau_g2, b.tau_g2);
    }

    #[test]
    fn generators_match_index_zero() {
        let (secret, srs) = generate_for_tests(8);
        // P0 = G1 and Q0 = G2 are PUBLIC constants, not unknown parameters (R2).
        assert_eq!(srs.tau_g1[0], G1Affine::generator());
        assert_eq!(srs.tau_g2[0], G2Affine::generator());
        assert_ne!(secret.tau, Fr::from(0u64));
        assert_ne!(secret.alpha, Fr::from(0u64));
        assert_ne!(secret.beta, Fr::from(0u64));
        assert_ne!(secret.tau, Fr::from(1u64));
    }

    #[test]
    fn beta_g2_is_beta_times_generator() {
        let (secret, srs) = generate_for_tests(8);
        let expected = G2Projective::generator()
            .mul_bigint(secret.beta.into_bigint())
            .into_affine();
        assert_eq!(srs.beta_g2, expected);
    }

    #[test]
    fn os_entropy_path_is_usable_and_not_the_fixed_seed() {
        let (random_secret, random_srs) = generate_from_os_entropy(8);
        let (fixed_secret, _) = generate_for_tests(8);
        assert_eq!(random_srs.tau_g1.len(), 15);
        assert_eq!(random_srs.tau_g1[0], G1Affine::generator());
        // Collision probability is negligible (~2^-255).
        assert_ne!(random_secret.tau, fixed_secret.tau);
    }
}

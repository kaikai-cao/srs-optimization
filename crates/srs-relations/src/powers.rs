use ark_bls12_381::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::PrimeField;
use ark_std::UniformRand;
use ark_std::rand::{SeedableRng, rngs::StdRng};

/// Fixed seed for the TEST-ONLY RNG. The resulting scalars are reproducible but
/// must never be used for any real ceremony or production SRS.
pub const SRS_SEED: [u8; 32] = [
    0x53, 0x52, 0x53, 0x2d, 0x4d, 0x32, 0x2d, 0x54, 0x45, 0x53, 0x54, 0x2d, 0x53, 0x45, 0x45, 0x44,
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];

pub const DEFAULT_N: usize = 32;

/// Trapdoor scalars. This struct exists only inside the generator and is dropped
/// before any public-parameter / recovery code runs.
/// Fields are intentionally never consumed by public code.
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

/// Generate a small, fully controlled BLS12-381 test SRS with a fixed-seed RNG.
/// Returns the secret scalars separately; callers must drop them before any
/// recovery experiment.
pub fn generate(n: usize) -> (SecretScalars, TestSrs) {
    assert!(n >= 2, "N must be at least 2");
    let mut rng = StdRng::from_seed(SRS_SEED);
    let tau = nonzero_scalar(&mut rng);
    let alpha = nonzero_scalar(&mut rng);
    let beta = nonzero_scalar(&mut rng);

    let g1 = G1Projective::generator();
    let g2 = G2Projective::generator();

    // tau^i * G1 for i = 0 .. 2N-2
    let mut coeff = Fr::from(1u64);
    let mut tau_g1 = Vec::with_capacity(2 * n - 1);
    for _ in 0..(2 * n - 1) {
        let p = g1.mul_bigint(coeff.into_bigint());
        tau_g1.push(p.into_affine());
        coeff *= tau;
    }

    // tau^j * G2 for j = 0 .. N-1
    let mut coeff = Fr::from(1u64);
    let mut tau_g2 = Vec::with_capacity(n);
    for _ in 0..n {
        let p = g2.mul_bigint(coeff.into_bigint());
        tau_g2.push(p.into_affine());
        coeff *= tau;
    }

    // alpha*tau^i * G1 and beta*tau^i * G1
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

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::AffineRepr;

    #[test]
    fn deterministic_and_correct_lengths() {
        let (_, a) = generate(8);
        let (_, b) = generate(8);
        assert_eq!(a.tau_g1.len(), 15);
        assert_eq!(a.tau_g2.len(), 8);
        assert_eq!(a.alpha_tau_g1.len(), 8);
        assert_eq!(a.beta_tau_g1.len(), 8);
        assert_eq!(a.tau_g1, b.tau_g1);
        assert_eq!(a.tau_g2, b.tau_g2);
    }

    #[test]
    fn generators_match_index_zero() {
        let (secret, srs) = generate(8);
        assert_eq!(srs.tau_g1[0], G1Affine::generator());
        assert_eq!(srs.tau_g2[0], G2Affine::generator());
        assert_ne!(secret.tau, Fr::from(0u64));
        assert_ne!(secret.alpha, Fr::from(0u64));
        assert_ne!(secret.beta, Fr::from(0u64));
        assert_ne!(secret.tau, Fr::from(1u64));
    }

    #[test]
    fn beta_g2_is_beta_times_generator() {
        let (secret, srs) = generate(8);
        let expected = G2Projective::generator()
            .mul_bigint(secret.beta.into_bigint())
            .into_affine();
        assert_eq!(srs.beta_g2, expected);
    }
}

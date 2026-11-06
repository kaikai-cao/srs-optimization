use crate::powers::TestSrs;
use ark_bls12_381::{Bls12_381, G1Affine, G2Affine};
use ark_ec::pairing::{Pairing, PairingOutput};

pub type Gt = PairingOutput<Bls12_381>;

pub fn pairing_g1_g2(p: G1Affine, q: G2Affine) -> Gt {
    Bls12_381::pairing(p, q)
}

#[derive(Debug, Clone, Copy)]
pub struct RelationCounts {
    pub tau: usize,
    pub alpha: usize,
    pub beta: usize,
}

impl RelationCounts {
    pub fn total(&self) -> usize {
        self.tau + self.alpha + self.beta
    }
}

/// Verify all three algebraic relations over every legal index combination.
///
/// R1: e(P_i, Q_j) = e(P_{i+j}, Q_0)       for i+j <= 2N-2
/// R2: e(A_i, Q_j) = e(A_{i+j}, Q_0)       for i+j <= N-1
/// R3: e(B_i, Q_0) = e(P_i, B_2)           for 0 <= i <= N-1
///
/// NOTE: these are structural consistency checks on a self-generated test SRS,
/// NOT a full Powers-of-Tau contribution verification.
pub fn verify_all(srs: &TestSrs) -> RelationCounts {
    let n = srs.n;
    let mut tau = 0usize;
    let mut alpha = 0usize;
    let mut beta = 0usize;

    for i in 0..=(2 * n - 2) {
        let max_j = (2 * n - 2 - i).min(n - 1);
        for j in 0..=max_j {
            let lhs = Bls12_381::pairing(srs.tau_g1[i], srs.tau_g2[j]);
            let rhs = Bls12_381::pairing(srs.tau_g1[i + j], srs.tau_g2[0]);
            assert_eq!(lhs, rhs, "tau relation failed at (i={}, j={})", i, j);
            tau += 1;
        }
    }

    for i in 0..n {
        let max_j = n - 1 - i;
        for j in 0..=max_j {
            let lhs = Bls12_381::pairing(srs.alpha_tau_g1[i], srs.tau_g2[j]);
            let rhs = Bls12_381::pairing(srs.alpha_tau_g1[i + j], srs.tau_g2[0]);
            assert_eq!(lhs, rhs, "alpha relation failed at (i={}, j={})", i, j);
            alpha += 1;
        }
    }

    for i in 0..n {
        let lhs = Bls12_381::pairing(srs.beta_tau_g1[i], srs.tau_g2[0]);
        let rhs = Bls12_381::pairing(srs.tau_g1[i], srs.beta_g2);
        assert_eq!(lhs, rhs, "beta relation failed at i={}", i);
        beta += 1;
    }

    RelationCounts { tau, alpha, beta }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::powers;

    #[test]
    fn small_n_all_relations_hold() {
        let (_, srs) = powers::generate_for_tests(4);
        let c = verify_all(&srs);
        assert_eq!(c.tau, 22);
        assert_eq!(c.alpha, 10);
        assert_eq!(c.beta, 4);
    }

    #[test]
    fn adjacent_tau_relation_holds() {
        let (_, srs) = powers::generate_for_tests(4);
        for i in 0..(2 * srs.n - 2) {
            assert_eq!(
                pairing_g1_g2(srs.tau_g1[i], srs.tau_g2[1]),
                pairing_g1_g2(srs.tau_g1[i + 1], srs.tau_g2[0])
            );
        }
    }
}

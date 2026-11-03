//! Daily spending accounting. Pure functions so they can be unit-tested
//! without a VM context.

use crate::types::Spent;

pub const NS_PER_DAY: u64 = 86_400_000_000_000;

/// UTC day number of a nanosecond timestamp.
pub fn day_of(ns: u64) -> u64 {
    ns / NS_PER_DAY
}

/// Reserve `amount` against the `daily` cap for the day of `now_ns`. A
/// previous day's total counts as zero (rollover). On error `spent` is left
/// unchanged.
pub fn reserve(
    spent: &mut Spent,
    now_ns: u64,
    amount: u128,
    daily: u128,
) -> Result<(), &'static str> {
    let today = day_of(now_ns);
    let current = if spent.day == today { spent.amount } else { 0 };
    match current.checked_add(amount) {
        Some(total) if total <= daily => {
            *spent = Spent {
                day: today,
                amount: total,
            };
            Ok(())
        }
        _ => Err("over daily cap"),
    }
}

/// Undo a reservation made on `reserved_day`. A no-op if the day has rolled
/// over since, so a release never credits the new day.
pub fn release(spent: &mut Spent, reserved_day: u64, amount: u128) {
    if spent.day == reserved_day {
        spent.amount = spent.amount.saturating_sub(amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const D: u64 = 20_000; // some UTC day
    const T: u64 = D * NS_PER_DAY + 3_600_000_000_000; // 01:00 on day D

    #[test]
    fn day_of_divides_by_ns_per_day() {
        assert_eq!(day_of(0), 0);
        assert_eq!(day_of(NS_PER_DAY - 1), 0);
        assert_eq!(day_of(NS_PER_DAY), 1);
        assert_eq!(day_of(T), D);
    }

    #[test]
    fn reserve_within_daily_ok() {
        let mut s = Spent::default();
        assert_eq!(reserve(&mut s, T, 2 * NEAR, 5 * NEAR), Ok(()));
        assert_eq!(reserve(&mut s, T, 3 * NEAR, 5 * NEAR), Ok(()));
        assert_eq!(
            s,
            Spent {
                day: D,
                amount: 5 * NEAR
            }
        );
    }

    #[test]
    fn reserve_over_daily_err() {
        let mut s = Spent {
            day: D,
            amount: 5 * NEAR,
        };
        assert_eq!(reserve(&mut s, T, 1, 5 * NEAR), Err("over daily cap"));
        assert_eq!(
            s,
            Spent {
                day: D,
                amount: 5 * NEAR
            }
        );
    }

    #[test]
    fn reserve_overflow_is_over_daily_cap() {
        let mut s = Spent { day: D, amount: 1 };
        assert_eq!(
            reserve(&mut s, T, u128::MAX, u128::MAX),
            Err("over daily cap")
        );
        assert_eq!(s.amount, 1);
    }

    #[test]
    fn reserve_resets_on_new_day() {
        let mut s = Spent {
            day: D,
            amount: 5 * NEAR,
        };
        assert_eq!(reserve(&mut s, T + NS_PER_DAY, NEAR, 5 * NEAR), Ok(()));
        assert_eq!(
            s,
            Spent {
                day: D + 1,
                amount: NEAR
            }
        );
    }

    #[test]
    fn release_same_day_subtracts() {
        let mut s = Spent::default();
        reserve(&mut s, T, 3 * NEAR, 5 * NEAR).unwrap();
        release(&mut s, D, 2 * NEAR);
        assert_eq!(
            s,
            Spent {
                day: D,
                amount: NEAR
            }
        );
        // Saturating: never below zero.
        release(&mut s, D, 10 * NEAR);
        assert_eq!(s, Spent { day: D, amount: 0 });
    }

    #[test]
    fn release_after_day_rollover_is_noop() {
        let mut s = Spent::default();
        reserve(&mut s, T, 2 * NEAR, 5 * NEAR).unwrap(); // day D, just before midnight in spirit
        reserve(&mut s, T + NS_PER_DAY, NEAR, 5 * NEAR).unwrap(); // day D+1
        release(&mut s, D, 2 * NEAR); // the day-D reservation comes back late
        assert_eq!(
            s,
            Spent {
                day: D + 1,
                amount: NEAR
            }
        );
    }
}

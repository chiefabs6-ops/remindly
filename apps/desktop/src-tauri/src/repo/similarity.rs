//! Cheap text similarity for duplicate hints (no AI needed).

use std::collections::HashSet;

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "to", "of", "and", "or", "for", "in", "on", "at", "with", "about", "my",
    "me", "is", "be", "please", "re",
];

/// Lowercase, keep letters/digits, drop stopwords, collapse spaces.
pub fn normalize(s: &str) -> String {
    let lowered: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect();
    lowered
        .split_whitespace()
        .filter(|w| !STOPWORDS.contains(w))
        .collect::<Vec<_>>()
        .join(" ")
}

fn trigrams(s: &str) -> HashSet<String> {
    let padded: Vec<char> = format!("  {s} ").chars().collect();
    padded
        .windows(3)
        .map(|w| w.iter().collect::<String>())
        .collect()
}

/// Sørensen–Dice coefficient over character trigrams of the normalized strings, 0.0..=1.0.
pub fn dice(a: &str, b: &str) -> f64 {
    let (na, nb) = (normalize(a), normalize(b));
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let (ta, tb) = (trigrams(&na), trigrams(&nb));
    let common = ta.intersection(&tb).count() as f64;
    2.0 * common / (ta.len() + tb.len()) as f64
}

/// Threshold above which two task titles are flagged as a possible duplicate.
pub const DUPLICATE_THRESHOLD: f64 = 0.65;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_titles_score_high() {
        assert!(dice("Follow up with Niamh", "follow-up with niamh!") > 0.95);
        assert!(
            dice(
                "Fix educator profile validation",
                "Fix the educator profile validation"
            ) > 0.9
        );
        assert!(dice("Fix educator profile validation", "Book dentist") < 0.3);
        assert_eq!(dice("", "x"), 0.0);
    }

    #[test]
    fn normalize_drops_noise() {
        assert_eq!(normalize("Please, call THE bank!"), "call bank");
    }
}

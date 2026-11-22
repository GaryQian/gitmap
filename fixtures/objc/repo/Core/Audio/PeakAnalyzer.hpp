#pragma once

#include <cstddef>
#include <vector>

namespace audio {

/// Reduces a sample buffer to one peak value per bucket.
class PeakAnalyzer {
public:
    explicit PeakAnalyzer(std::size_t buckets) : buckets_(buckets) {}

    std::vector<float> computePeaks(const std::vector<float> &samples) const {
        std::vector<float> peaks(buckets_, 0.0f);
        if (samples.empty() || buckets_ == 0) return peaks;
        const std::size_t per = (samples.size() + buckets_ - 1) / buckets_;
        for (std::size_t i = 0; i < samples.size(); ++i) {
            const float v = samples[i] < 0 ? -samples[i] : samples[i];
            if (v > peaks[i / per]) peaks[i / per] = v;
        }
        return peaks;
    }

private:
    std::size_t buckets_;
};

/// Scales the peaks so the largest becomes 1.
inline void normalizePeaks(std::vector<float> &peaks) {
    float top = 0.0f;
    for (float p : peaks) top = p > top ? p : top;
    if (top <= 0.0f) return;
    for (float &p : peaks) p /= top;
}

}  // namespace audio

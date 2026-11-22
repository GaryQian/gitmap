// Package config loads the service configuration.
package config

import (
	"fmt"
	"os"

	yaml "gopkg.in/yaml.v3"
)

// usage is shown when the file cannot be read. It mentions an import on purpose:
// the text below is data, not a dependency of this package.
const usage = `expected a file like:

addr: ":8080"
tax_rate: 0.2

To change how totals are computed, edit the package behind
import "example.com/shop/pkg/pricing"
`

// Config is the content of shop.yaml.
type Config struct {
	Addr    string  `yaml:"addr"`
	TaxRate float64 `yaml:"tax_rate"`
}

// Load reads and validates the configuration file at path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w\n%s", err, usage)
	}
	cfg := &Config{Addr: ":8080"}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if cfg.TaxRate < 0 {
		return nil, fmt.Errorf("%s: tax_rate must not be negative", path)
	}
	return cfg, nil
}

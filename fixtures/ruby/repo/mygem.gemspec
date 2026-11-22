require_relative 'lib/mygem/version'

Gem::Specification.new do |spec|
  spec.name = 'mygem'
  spec.version = Mygem::VERSION
  spec.summary = 'Fetches account data over HTTP.'
  spec.files = Dir['lib/**/*.rb']
  spec.require_paths = ['lib']
end

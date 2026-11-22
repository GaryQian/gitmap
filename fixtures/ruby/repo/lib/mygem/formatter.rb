require 'json'

module Mygem
  # Renders API payloads for terminals.
  class Formatter
    def pretty(payload)
      JSON.pretty_generate(payload)
    end
  end
end

__END__
Scratch notes kept out of the program:
require_relative 'client'
Mygem::Client.new('token').account(1)

require 'json'
require 'mygem/version'
require 'mygem/client'

# Entry point of the gem.
module Mygem
  class Error < StandardError; end

  autoload :Formatter, 'mygem/formatter'

  def self.client(token)
    Client.new(token)
  end

  def self.parse(body)
    JSON.parse(body)
  rescue JSON::ParserError => e
    raise Error, e.message
  end
end

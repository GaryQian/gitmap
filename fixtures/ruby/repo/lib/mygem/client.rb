require 'net/http'
require_relative 'transport/http'

module Mygem
  # Talks to the accounts API.
  class Client
    DEFAULT_HOST = 'accounts.example.com'

    def initialize(token, host: DEFAULT_HOST)
      @transport = Transport::Http.new(host, token)
    end

    def account(id)
      body = @transport.get("/accounts/#{id}")
      Formatter.new.pretty(Mygem.parse(body))
    end

    def user_agent
      ['mygem', VERSION].join('/')
    end
  end
end

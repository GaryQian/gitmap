require 'net/http'
require_relative '../version'

module Mygem
  module Transport
    # Thin wrapper around Net::HTTP.
    class Http
      USAGE = <<~TEXT
        Example:
          require 'mygem/formatter'
          Mygem::Formatter.new.pretty(payload)
      TEXT

      def initialize(host, token)
        @host = host
        @token = token
      end

      def get(path)
        request = Net::HTTP::Get.new(path, headers)
        Net::HTTP.start(@host, 443, use_ssl: true) { |http| http.request(request) }.body
      end

      private

      def headers
        { 'Authorization' => "Bearer #{@token}", 'User-Agent' => "mygem/#{VERSION}" }
      end
    end
  end
end

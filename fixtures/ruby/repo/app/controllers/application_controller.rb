class ApplicationController < ActionController::Base
  before_action :authenticate

  private

  def authenticate
    head :unauthorized unless request.headers['Authorization']
  end
end

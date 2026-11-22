class UsersController < ApplicationController
  def index
    render json: User.active
  end

  def create
    user = User.new(params.require(:user).permit(:name, :email))
    user.track!('signup')
    UserMailer.welcome(user).deliver_later
    render json: user, status: :created
  end

  def legacy
    render json: LegacyAccount.find(params[:id])
  end

  def remote
    render json: Mygem::Client.new(ENV.fetch('MYGEM_TOKEN')).account(params[:id])
  end
end

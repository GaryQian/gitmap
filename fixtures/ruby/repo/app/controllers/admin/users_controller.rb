module Admin
  class UsersController < ApplicationController
    PER_PAGE = 50

    def index
      render json: User.order(:name).limit(PER_PAGE)
    end

    def destroy
      User.find(params[:id]).destroy
      head :no_content
    end
  end
end

class UserMailer < ApplicationMailer
  def welcome(user)
    @user = user
    @admins = User.where(role: 'admin')
    mail(to: user.email, subject: 'Welcome aboard')
  end
end

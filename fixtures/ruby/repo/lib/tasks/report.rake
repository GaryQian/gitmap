namespace :admin do
  desc 'Print how many users the admin actions can reach'
  task report: :environment do
    actions = Admin::UsersController.action_methods
    total = User.count
    puts "#{total} users, #{actions.size} admin actions"
  end
end

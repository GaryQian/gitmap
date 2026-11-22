class User < ApplicationRecord
  include Trackable

  ROLES = %w[member admin].freeze

  validates :email, presence: true
  validates :role, inclusion: { in: ROLES }

  def self.active
    where(active: true)
  end

  def admin?
    role == 'admin'
  end
end

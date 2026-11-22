module Trackable
  extend ActiveSupport::Concern

  included do
    has_many :events, as: :subject
  end

  def track!(name)
    events.create!(name: name)
  end
end

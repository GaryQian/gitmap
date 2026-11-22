# Built at load time from the legacy schema, so no `class` keyword names it:
# other files can only find it through the autoloader's naming convention.
Object.const_set(:LegacyAccount, Class.new(ApplicationRecord) do
  self.table_name = 'accounts_v1'
end)

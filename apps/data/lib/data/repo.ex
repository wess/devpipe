#
#  repo.ex
#  data
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

defmodule Data.Repo do
  use Ecto.Repo,
    otp_app: :data,
    adapter: Ecto.Adapters.Postgres
end

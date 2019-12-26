#
#  application.ex
#  data
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

defmodule Data.Application do
  use Application
  require Logger

  def start(_type, _args) do
    children = [
      {Data.Repo, []},
    ]

    opts = [strategy: :one_for_one, name: Data.Supervisor]
    
    Logger.info(fn-> "Starting data..." end)
    Supervisor.start_link(children, opts)
  end
end

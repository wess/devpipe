#
#  application.ex
#  api
# 
#  Created by Wess Cope (me@wess.io) on 12/11/19
#  Copyright 2019 Wess Cope
#

defmodule Api.Application do
  require Logger
  use Application

  def start(_type, _args) do
    children = [
      {
        Plug.Cowboy, 
        scheme:   :http,
        plug:     Api, 
        options:  [port: 8080]
      }
    ]

    opts = [strategy: :one_for_one, name: Api.Supervisor]
    
    Logger.info(fn-> "Starting api..." end)
    Supervisor.start_link(children, opts)
  end

end

#
#  router.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 11/12/19
#  Copyright 2019 Wess Cope
#

defmodule Router do
  defmacro __using__(_) do
    quote do
      require Logger
      import Plug.Conn

      use Plug.Router
      use Responses

      import unquote(__MODULE__)

      plug Plug.Parsers, 
      parsers: [:urlencoded, :multipart, :json],
      pass: ["*/*"],
      json_decoder: Jason
    end
  end
end

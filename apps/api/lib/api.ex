#
#  api.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/11/19
#  Copyright 2019 Wess Cope
#

defmodule Api do
  use Router

  plug :match
  plug :dispatch
  
  #### V1
  forward "/v1/documents",    to: Documents
  forward "/v1/attachments",  to: Attachments

  match _ do
    conn
    |> json(404, %{error: "not found"})
  end
end

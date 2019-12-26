#
#  config.exs
#  config
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

import Mix.Config


config :data, Data.Repo,
  database: "devpipe",
  username: "postgres",
  password: "",
  hostname: "localhost"

config :data, ecto_repos: [Data.Repo]

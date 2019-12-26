#
#  config.exs
#  config
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

import Mix.Config

config :attachments, ecto_repos: [Data.Repo]

config :waffle, 
  storage:              Waffle.Storage.Local,
  storage_dir_prefix:   "priv/attachments"

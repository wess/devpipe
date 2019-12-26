#
#  provider.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 11/12/19
#  Copyright 2019 Wess Cope
#

defmodule Provider do
  defmacro __using__(_) do
    quote do
      import 	Ecto.Query
    end
  end
end

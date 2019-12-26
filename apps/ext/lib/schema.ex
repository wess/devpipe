#
#  schema.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 11/15/19
#  Copyright 2019 Wess Cope
#

defmodule Schema do
  defmacro __using__(_) do
    quote do
      use 		Ecto.Schema
      import 	Ecto.Changeset
      import 	Ecto.Query

      @primary_key 			{:id, :binary_id, autogenerate: true}
      @foreign_key_type :binary_id
    end
  end
end

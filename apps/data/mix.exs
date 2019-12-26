#
#  mix.exs
#  data
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

defmodule Data.MixProject do
  use Mix.Project

  def project do
    [
      app:              :data,
      version:          "0.0.1",
      build_path:       "../../_build",
      deps_path:        "../../deps",
      lockfile:         "../../mix.lock",
      elixir:           "~> 1.9",
      start_permanent:  Mix.env() == :prod,
      deps:             deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {Data.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:ecto_sql, "~> 3.2"},
			{:postgrex, "~> 0.15"},
      {:ext,      in_umbrella: true}
    ]
  end
end


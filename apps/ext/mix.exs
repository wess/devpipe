#
#  mix.exs
#  ext
# 
#  Created by Wess Cope (me@wess.io) on 12/11/19
#  Copyright 2019 Wess Cope
#

defmodule Ext.MixProject do
  use Mix.Project

  def project do
    [
      app:              :ext,
      version:          "0.0.1",
      build_path:       "../../_build",
      config_path:      "../../config/config.exs",
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
      extra_applications: [:logger]
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:plug_cowboy,  "~> 2.0"},
      {:ecto_sql,     "~> 3.2"},
      {:postgrex,     "~> 0.15"},
      {:jason,        "~> 1.1"},
      {:mimerl,       "~> 1.2.0"},
    ]
  end
end
